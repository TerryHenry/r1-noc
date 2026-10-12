#!/usr/bin/env python3
"""Assemble an OVA (OVF 1.0 descriptor + manifest + stream-optimized VMDK) — usage: mkovf.py <vmdk> <out.ova> <version> [capacity-GiB]"""
import hashlib, os, sys, tarfile, datetime
vmdk, out, ver = sys.argv[1], sys.argv[2], sys.argv[3]; cap = int(sys.argv[4]) if len(sys.argv) > 4 else 8
name = f"R1-NOC-Wall-{ver}"; vmdk_name = f"{name}-disk1.vmdk"; size = os.path.getsize(vmdk)
ovf = f'''<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:cim="http://schemas.dmtf.org/wbem/wscim/1/common" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1" xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData" xmlns:vmw="http://www.vmware.com/schema/ovf" xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <References>
    <File ovf:href="{vmdk_name}" ovf:id="file1" ovf:size="{size}"/>
  </References>
  <DiskSection>
    <Info>Virtual disk information</Info>
    <Disk ovf:capacity="{cap}" ovf:capacityAllocationUnits="byte * 2^30" ovf:diskId="vmdisk1" ovf:fileRef="file1" ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized" ovf:populatedSize="{size}"/>
  </DiskSection>
  <NetworkSection>
    <Info>The list of logical networks</Info>
    <Network ovf:name="VM Network"><Description>VM Network</Description></Network>
  </NetworkSection>
  <VirtualSystem ovf:id="{name}">
    <Info>R1 NOC Wall virtual appliance</Info>
    <Name>{name}</Name>
    <OperatingSystemSection ovf:id="96" vmw:osType="debian12_64Guest">
      <Info>The kind of installed guest operating system</Info>
      <Description>Debian GNU/Linux 12 (64-bit)</Description>
    </OperatingSystemSection>
    <ProductSection>
      <Info>Product information</Info>
      <Product>R1 NOC Wall</Product>
      <Vendor>R1 NOC Wall</Vendor>
      <Version>{ver}</Version>
      <FullVersion>{ver} ({datetime.date.today().isoformat()})</FullVersion>
      <ProductUrl>https://github.com/TerryHenry/r1-noc</ProductUrl>
    </ProductSection>
    <AnnotationSection ovf:required="false">
      <Info>First steps</Info>
      <Annotation>Power on and read the address on the console. Wall: https://&lt;ip&gt;/  Editor: https://&lt;ip&gt;/admin?key=&lt;shown on the console&gt;. Console login: noc / noc (change on first login), then run: sudo r1-noc-config. DHCP is used until you set a static address.</Annotation>
    </AnnotationSection>
    <VirtualHardwareSection>
      <Info>Virtual hardware requirements</Info>
      <System>
        <vssd:ElementName>Virtual Hardware Family</vssd:ElementName>
        <vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>{name}</vssd:VirtualSystemIdentifier>
        <vssd:VirtualSystemType>vmx-13</vssd:VirtualSystemType>
      </System>
      <Item>
        <rasd:AllocationUnits>hertz * 10^6</rasd:AllocationUnits>
        <rasd:Description>Number of Virtual CPUs</rasd:Description>
        <rasd:ElementName>2 virtual CPU(s)</rasd:ElementName>
        <rasd:InstanceID>1</rasd:InstanceID>
        <rasd:ResourceType>3</rasd:ResourceType>
        <rasd:VirtualQuantity>2</rasd:VirtualQuantity>
      </Item>
      <Item>
        <rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits>
        <rasd:Description>Memory Size</rasd:Description>
        <rasd:ElementName>2048MB of memory</rasd:ElementName>
        <rasd:InstanceID>2</rasd:InstanceID>
        <rasd:ResourceType>4</rasd:ResourceType>
        <rasd:VirtualQuantity>2048</rasd:VirtualQuantity>
      </Item>
      <Item>
        <rasd:Address>0</rasd:Address>
        <rasd:Description>SCSI Controller</rasd:Description>
        <rasd:ElementName>SCSI Controller 0</rasd:ElementName>
        <rasd:InstanceID>3</rasd:InstanceID>
        <rasd:ResourceSubType>lsilogic</rasd:ResourceSubType>
        <rasd:ResourceType>6</rasd:ResourceType>
      </Item>
      <Item>
        <rasd:AddressOnParent>0</rasd:AddressOnParent>
        <rasd:ElementName>Hard Disk 1</rasd:ElementName>
        <rasd:HostResource>ovf:/disk/vmdisk1</rasd:HostResource>
        <rasd:InstanceID>4</rasd:InstanceID>
        <rasd:Parent>3</rasd:Parent>
        <rasd:ResourceType>17</rasd:ResourceType>
      </Item>
      <Item>
        <rasd:AddressOnParent>7</rasd:AddressOnParent>
        <rasd:AutomaticAllocation>true</rasd:AutomaticAllocation>
        <rasd:Connection>VM Network</rasd:Connection>
        <rasd:Description>E1000 ethernet adapter on "VM Network"</rasd:Description>
        <rasd:ElementName>Ethernet 1</rasd:ElementName>
        <rasd:InstanceID>5</rasd:InstanceID>
        <rasd:ResourceSubType>E1000</rasd:ResourceSubType>
        <rasd:ResourceType>10</rasd:ResourceType>
      </Item>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
'''
d = os.path.dirname(os.path.abspath(out)); ovf_path = os.path.join(d, f"{name}.ovf"); mf_path = os.path.join(d, f"{name}.mf")
open(ovf_path, "w").write(ovf)
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
open(mf_path, "w").write(f"SHA256({name}.ovf)= {sha(ovf_path)}\nSHA256({vmdk_name})= {sha(vmdk)}\n")
with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as t:   # OVA = tar, descriptor first
    t.add(ovf_path, arcname=f"{name}.ovf"); t.add(mf_path, arcname=f"{name}.mf"); t.add(vmdk, arcname=vmdk_name)
os.remove(ovf_path); os.remove(mf_path)
print(f"{out}  {os.path.getsize(out)/1048576:.0f} MB")
